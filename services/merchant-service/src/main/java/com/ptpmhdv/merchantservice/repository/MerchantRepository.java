package com.ptpmhdv.merchantservice.repository;

import com.ptpmhdv.merchantservice.model.Merchant;
import com.ptpmhdv.merchantservice.model.MerchantStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface MerchantRepository extends JpaRepository<Merchant, String> {
    Optional<Merchant> findByOwnerId(String ownerId);
    Page<Merchant> findByStatus(MerchantStatus status, Pageable pageable);
    Page<Merchant> findByBusinessNameContainingIgnoreCase(String businessName, Pageable pageable);
    Page<Merchant> findByStatusAndBusinessNameContainingIgnoreCase(MerchantStatus status, String businessName, Pageable pageable);
}
